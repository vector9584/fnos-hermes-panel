import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../../app/ui/index.html', import.meta.url), 'utf8');
const source = html.slice(html.indexOf('function renderCronJobs(){'), html.indexOf('function cronAction(jobId, action){'));
async function render(jobs, options = {}) {
  const element = {innerHTML: ''};
  const context = {document: {getElementById: () => element}, window: options,
    apiGet: async () => ({ok: true, jobs, webhooks: {}}), _cronJobs: [], esc: value => String(value).replaceAll('<', '&lt;')};
  vm.createContext(context); vm.runInContext(source + '\nrenderCronJobs();', context);
  await new Promise(resolve => setImmediate(resolve));
  return element.innerHTML;
}
test('paused, completed and archived tasks show their actual lifecycle and retain history access', async () => {
  const jobs = [{id: 'paused', name: '暂停任务', state: 'paused', enabled: false},
    {id: 'finished', name: '完成任务', state: 'completed', enabled: false},
    {id: 'archived', name: '归档任务', panel_archived: true}];
  const text = await render(jobs, {_cronShowArchived: true, _cronShowDone: true});
  assert.match(text, /已暂停/); assert.match(text, /已完成/); assert.match(text, /已归档/);
  assert.match(text, /openCronHistory\('archived'\)/);
  assert.doesNotMatch(text, /cronAction\('finished','resume'\)/);
  assert.doesNotMatch(text, /cronAction\('archived','run'\)/);
  assert.doesNotMatch(text, />删除</);
});
test('delivery error is visible independently of successful execution', async () => {
  const text = await render([{id: 'job', name: '成功但未送达', last_status: 'ok', last_delivery_error: '渠道超时',
    schedule: {kind: 'interval', minutes: 30}, deliver: 'discord:target'}]);
  assert.match(text, />成功</); assert.match(text, /渠道投递失败：渠道超时/);
  assert.match(text, /每 30 分钟/); assert.match(text, /discord:target/);
  assert.doesNotMatch(text, /立即执行/);
});
