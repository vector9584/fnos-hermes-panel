import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {handleCustomRoute} from '../../../app/server/custom_routes.js';

const fusion = fs.readFileSync(new URL('../../../app/ui/js/fusion-v030.js', import.meta.url), 'utf8');
const navigation = fs.readFileSync(new URL('../../../app/ui/js/panel-navigation.js', import.meta.url), 'utf8');
const plans = fs.readFileSync(new URL('../../../app/ui/js/panel-plans-ui.js', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../../../app/server/custom_routes.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('../../../app/ui/index.html', import.meta.url), 'utf8');
const reviews = fs.readFileSync(new URL('../../../app/server/panel-library-reviews.js', import.meta.url), 'utf8');

test('legacy flow URLs resolve to plans without exposing the retired DAG editor', () => {
  assert.match(fusion, /name==='flows'\) name='plans'/);
  assert.match(navigation, /flows:'plans'/);
  assert.doesNotMatch(index, /switchExpertPickerTab\('workflow'\)|_expertPickerTab==='workflow'/);
  assert.doesNotMatch(index, /workflowEditorModal|function renderWorkflowPresets\(|function openWorkflowTemplateEditor\(|function applyWorkflow\(/);
  assert.match(plans, /document\.getElementById\('workflowEditorModal'\)\?\.remove\(\)/);
  for (const retired of ['page-flows', 'flowCreateDialog', 'flowCreateConfirm', 'flowRun', 'flowDelete', "api30('/api/flows'"]) {
    assert.equal(fusion.includes(retired), false, `retired workflow UI remains: ${retired}`);
  }
  assert.match(plans, /panel-plan-editor/);
});

test('the orphaned inline workflow catalog is absent while task plans remain server-backed', () => {
  assert.doesNotMatch(index, /window\.AO_WORKFLOW_PRESETS\s*=/);
  assert.match(plans, /\/api\/panel-plans/);
  assert.match(fs.readFileSync(new URL('../../../app/server/panel-plans.js', import.meta.url), 'utf8'), /workflow_templates_override/);
  assert.match(fs.readFileSync(new URL('../../../app/server/task-templates.json', import.meta.url), 'utf8'), /"key"\s*:/);
});

test('legacy flow records remain readable and write routes reject mutation', () => {
  assert.match(routes, /const FLOWS_DIR = `\$\{DATA_DIR\}\/flows`/);
  assert.match(routes, /path === "\/api\/flows" && method === "GET"/);
  assert.match(routes, /path === '\/api\/flows' \|\| path\.startsWith\('\/api\/flows\/'\).*status:410/);
  for (const retired of ['_saveFlow', '_runFlowStep', 'flow started', 'fsub === "run"', 'fsub === "" && method === "DELETE"']) {
    assert.equal(routes.includes(retired), false, `retired flow execution remains: ${retired}`);
  }
});

test('legacy memory mutation routes stay retired while reviewed drafts remain the supported path', () => {
  assert.match(routes, /\['\/api\/memory\/distill','\/api\/memory\/curator\/run','\/api\/kb\/import-memory','\/api\/memory\/daily','\/api\/evolution'\].*status:410/);
  for (const unsafe of [
    'MEMORY.md.distill-bak-',
    'sensenova-6.7-flash-lite',
    'knowledge/记忆/',
    'copyFileSync(f.src',
    'writeFileSync(`${_activeProfileDir}/memories/MEMORY.md`',
  ]) assert.equal(routes.includes(unsafe), false, `retired memory mutation remains: ${unsafe}`);
  assert.match(reviews, /async create\(body\)/);
  assert.match(reviews, /apply\(id,body\)/);
  assert.match(reviews, /原资料未修改/);
});

test('retired memory endpoints reject all supported methods', async () => {
  for (const [path, method] of [
    ['/api/memory/distill', 'POST'],
    ['/api/memory/curator/run', 'POST'],
    ['/api/kb/import-memory', 'POST'],
    ['/api/memory/daily', 'GET'],
    ['/api/memory/daily', 'POST'],
    ['/api/evolution', 'GET'],
  ]) {
    const response = await handleCustomRoute(new Request('http://fixture' + path, {method, body: method === 'POST' ? '{}' : undefined}));
    assert.equal(response.status, 410, `${method} ${path}`);
    assert.equal((await response.json()).ok, false);
  }
});
